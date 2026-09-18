import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { fold } from '../src/lib/core/projection/fold.ts';
import { INITIAL_PHASE, phaseReducer } from '../src/lib/core/projection/phase.ts';
import { loadAppendedEvents, PAGE_SIZE } from '../src/lib/server/event-log.ts';
import { PHASE_SENTENCES, resolveLeaguePhase, resolveLeaguePhaseOrDefault } from '../src/lib/server/phase.ts';
import { toAppendedEvent } from '../src/lib/shell/write.ts';

/**
 * Simulates a missing `SUPABASE_SERVICE_ROLE_KEY` — the single most likely
 * real trigger for `resolveLeaguePhaseOrDefault`'s no-argument path, which
 * every other test in this file bypasses by always passing an explicit fake
 * client. `serviceRoleClient()` (`server/supabase.ts`) throws via its own
 * `required()` guard when this is unset.
 */
vi.mock('$env/dynamic/private', () => ({ env: {} }));

/**
 * `resolveLeaguePhase`/`resolveLeaguePhaseOrDefault`/`loadAppendedEvents`,
 * exercised against a fake `SupabaseClient` — the same style
 * `supabase-registry.test.ts` and `commissioner-guard.test.ts` already use,
 * so this is a real query shape driven end to end rather than a hand-built
 * `AppendedEvent[]` handed straight to `fold()` (that lower-level guarantee
 * is `tests/phase-projection.test.ts`'s job).
 */

/** One `auction_events` row, as Postgrest would shape it, for seq `n`. */
function row(n: number, type = 'Marker'): Record<string, unknown> {
	return {
		seq: String(n),
		occurred_at: '2026-08-22T00:00:00.000Z',
		schema_version: 1,
		core_version: 1,
		manager_id: 'm-1',
		team_id: 't-1',
		event_type: type,
		payload: { marker: n },
		device_class: null,
		dispatch_outcome: null,
		delivery_outcome: null
	};
}

/**
 * A fake client backing `auction_events` with `total` rows, answering each
 * `.range()` request in full up to `total`. Records every call so a test can
 * assert both the call shape and that every row was actually accumulated
 * across pages, not merely that more than one page was requested.
 */
function fakeEventsClient(total: number): {
	client: SupabaseClient;
	ranges: Array<[number, number]>;
} {
	const ranges: Array<[number, number]> = [];
	const query = {
		select: () => query,
		gt: () => query,
		order: () => query,
		async range(from: number, to: number) {
			ranges.push([from, to]);
			const rows: Array<Record<string, unknown>> = [];
			for (let n = from + 1; n <= Math.min(to + 1, total); n++) {
				rows.push(row(n));
			}
			return { data: rows, error: null };
		}
	};
	return { client: { from: () => query } as unknown as SupabaseClient, ranges };
}

/**
 * A fake client that never returns more than `cap` rows per call, regardless
 * of how wide a range is requested — simulating a server-side row cap
 * (PostgREST's `db-max-rows`, or an equivalent) smaller than `PAGE_SIZE`.
 * `loadAppendedEvents` cannot read that cap; it can only observe it by a
 * response coming back short of what was asked for while more rows remain.
 */
function cappedEventsClient(
	total: number,
	cap: number
): { client: SupabaseClient; ranges: Array<[number, number]> } {
	const ranges: Array<[number, number]> = [];
	const query = {
		select: () => query,
		gt: () => query,
		order: () => query,
		async range(from: number, to: number) {
			ranges.push([from, to]);
			const requestedEnd = Math.min(to + 1, total);
			const cappedEnd = Math.min(from + cap, requestedEnd);
			const rows: Array<Record<string, unknown>> = [];
			for (let n = from + 1; n <= cappedEnd; n++) {
				rows.push(row(n));
			}
			return { data: rows, error: null };
		}
	};
	return { client: { from: () => query } as unknown as SupabaseClient, ranges };
}

/** A fake client whose `.range()` always fails with a Postgrest-shaped error. */
function failingEventsClient(message: string): SupabaseClient {
	const query = {
		select: () => query,
		gt: () => query,
		order: () => query,
		async range() {
			return { data: null, error: { message } };
		}
	};
	return { from: () => query } as unknown as SupabaseClient;
}

/** A fake client whose response shape is wrong: `data` is non-null but not an array. */
function malshapedEventsClient(): SupabaseClient {
	const query = {
		select: () => query,
		gt: () => query,
		order: () => query,
		async range() {
			return { data: { unexpected: 'object, not an array' }, error: null };
		}
	};
	return { from: () => query } as unknown as SupabaseClient;
}

describe('loadAppendedEvents', () => {
	it('reads a small log, terminating on the empty page rather than the first short one', async () => {
		// Terminating on `data.length === 0` rather than "shorter than
		// PAGE_SIZE" costs one extra, empty round trip here — the price of not
		// assuming a short page means "no more data" (see the cap test below).
		const { client, ranges } = fakeEventsClient(3);
		const events = await loadAppendedEvents(client);
		expect(events.map((e) => e.seq)).toEqual(['1', '2', '3']);
		expect(ranges).toEqual([
			[0, PAGE_SIZE - 1],
			[3, PAGE_SIZE + 2]
		]);
	});

	it('paginates rather than trusting a single unbounded select, and accumulates every row across pages', async () => {
		// A single unbounded select relies on PostgREST's row cap never being
		// hit; hitting it arrives as a successful *partial* response, not an
		// error, which would silently truncate the fold below "the full log".
		const total = PAGE_SIZE + 5;
		const { client, ranges } = fakeEventsClient(total);

		const events = await loadAppendedEvents(client);

		expect(ranges.length).toBeGreaterThan(1);
		// Assert the actual accumulated count and identity of every row, not
		// only that more than one page was requested — a page silently dropped
		// between calls would still leave `ranges.length > 1` true.
		expect(events).toHaveLength(total);
		expect(events.map((e) => e.seq)).toEqual(
			Array.from({ length: total }, (_, i) => String(i + 1))
		);
	});

	it('accumulates every row even when the server caps each response below PAGE_SIZE', async () => {
		// The server's actual per-response row cap is a deployment setting
		// this module cannot read. Terminating on "a page shorter than
		// PAGE_SIZE" — rather than on an empty page — would have stopped after
		// the very first response here, silently truncating a 250-row log to
		// the 100 rows the capped server happened to return for it.
		const total = 250;
		const { client, ranges } = cappedEventsClient(total, 100);

		const events = await loadAppendedEvents(client);

		expect(events).toHaveLength(total);
		expect(events.map((e) => e.seq)).toEqual(
			Array.from({ length: total }, (_, i) => String(i + 1))
		);
		expect(ranges.length).toBeGreaterThan(1);
	});

	it('throws a descriptive error on a query failure — a database outage is not "no events"', async () => {
		const client = failingEventsClient('connection refused');
		await expect(loadAppendedEvents(client)).rejects.toThrow(/auction_events read failed/);
		await expect(loadAppendedEvents(client)).rejects.toThrow(/connection refused/);
	});

	it('guards a non-array response shape rather than crashing on a non-iterable', async () => {
		await expect(loadAppendedEvents(malshapedEventsClient())).rejects.toThrow(
			/auction_events read failed/
		);
	});
});

describe('resolveLeaguePhase', () => {
	it('folds INITIAL_PHASE over the full log via the pure reducer, wrapped via phaseOf', async () => {
		const { client } = fakeEventsClient(3);
		const resolved = await resolveLeaguePhase(client);
		expect(resolved.name).toBe('Setup');
		expect(resolved.sentence).toBe(PHASE_SENTENCES.Setup);
	});

	it('a full rebuild via the DB-backed path converges with a genuinely incremental fold built from the same events (AD-5)', async () => {
		// tests/phase-projection.test.ts proves this at the reducer level
		// directly; this proves it at this module's level too — resolving
		// through the real loadAppendedEvents/fold pipeline, folded from
		// empty, must agree with a prefix folded and the remainder folded onto
		// that result, rather than merely folding the same events from empty
		// state twice and calling that "incremental".
		const total = 6;
		const { client } = fakeEventsClient(total);
		// Reuses the same row-mapping `event-log.ts` itself calls, rather than a
		// second hand-built copy that could silently drift from it.
		const all = Array.from({ length: total }, (_, i) => toAppendedEvent(row(i + 1)));

		const resolved = await resolveLeaguePhase(client);

		const afterPrefix = fold(INITIAL_PHASE, all.slice(0, 2), phaseReducer);
		const incremental = fold(afterPrefix, all.slice(2), phaseReducer);

		expect(resolved.name).toBe(incremental);
		expect(resolved.name).toBe('Setup');
	});

	it('rejects when the underlying read fails — the throw resolveLeaguePhaseOrDefault depends on', async () => {
		const client = failingEventsClient('connection refused');
		await expect(resolveLeaguePhase(client)).rejects.toThrow(/connection refused/);
	});
});

describe('resolveLeaguePhaseOrDefault', () => {
	it('resolves normally when the read succeeds', async () => {
		const { client } = fakeEventsClient(0);
		const resolved = await resolveLeaguePhaseOrDefault(client);
		expect(resolved.name).toBe('Setup');
	});

	it('fails closed to Setup on a query error rather than rejecting', async () => {
		const client = failingEventsClient('connection refused');
		const resolved = await resolveLeaguePhaseOrDefault(client);
		expect(resolved.name).toBe('Setup');
		expect(resolved.sentence).toBe(PHASE_SENTENCES.Setup);
	});

	it('fails closed to Setup on a malshaped response, not only a query error', async () => {
		const resolved = await resolveLeaguePhaseOrDefault(malshapedEventsClient());
		expect(resolved.name).toBe('Setup');
	});

	it('fails closed to Setup for any thrown error, not only a Postgrest error shape', async () => {
		const client = {
			from() {
				throw new Error('boom');
			}
		} as unknown as SupabaseClient;
		const resolved = await resolveLeaguePhaseOrDefault(client);
		expect(resolved.name).toBe('Setup');
	});

	it('fails closed to Setup even when building the default client itself throws — a missing SUPABASE_SERVICE_ROLE_KEY, not only a query failure', async () => {
		// Called with no argument on purpose: this is the one path that
		// actually reaches `serviceRoleClient()`. A default-parameter
		// expression evaluates before a function's own body runs, so if that
		// call were still written as a default parameter (as it was before
		// this test existed), its throw would reject uncaught, bypassing the
		// `try`/`catch` entirely — the exact regression this test guards.
		const resolved = await resolveLeaguePhaseOrDefault();
		expect(resolved.name).toBe('Setup');
	});
});
